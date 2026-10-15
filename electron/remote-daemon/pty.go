package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/creack/pty"
)

type ptyEntry struct {
	id   string
	pty  *os.File
	cmd  *exec.Cmd
	mu   sync.Mutex
	dead bool
}

type ptyRegistry struct {
	srv *server
	mu  sync.Mutex
	m   map[string]*ptyEntry
	seq uint64
}

func newPtyRegistry(srv *server) *ptyRegistry {
	return &ptyRegistry{srv: srv, m: map[string]*ptyEntry{}}
}

type ptyStartParams struct {
	Cmd  string   `json:"cmd"`
	Args []string `json:"args"`
	Cols uint16   `json:"cols"`
	Rows uint16   `json:"rows"`
	Cwd  string   `json:"cwd"`
	Env  []string `json:"env"`
}

func (r *ptyRegistry) handleStart(params json.RawMessage) (interface{}, *rpcError) {
	var p ptyStartParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params: " + err.Error()}
	}
	if p.Cols == 0 {
		p.Cols = 100
	}
	if p.Rows == 0 {
		p.Rows = 28
	}
	userShell := resolveUserShell()

	var runCmd string
	var runArgs []string
	if p.Cmd == "" {
		runCmd = userShell
		runArgs = []string{"-il"}
	} else {
		shellCmd := shellQuote(p.Cmd)
		for _, a := range p.Args {
			shellCmd += " " + shellQuote(a)
		}
		runCmd = userShell
		runArgs = []string{"-ilc", "exec " + shellCmd}
	}

	c := exec.Command(runCmd, runArgs...)
	if p.Cwd != "" {
		c.Dir = p.Cwd
	}
	env := append(os.Environ(), p.Env...)
	if hasEnv(p.Env, "ACE_UNSET_NO_COLOR") {
		env = removeEnv(env, "NO_COLOR")
	}
	if !hasEnv(env, "TERM") {
		env = append(env, "TERM=xterm-256color")
	}
	env = setEnv(env, "SHELL", userShell)
	c.Env = env

	f, err := pty.StartWithSize(c, &pty.Winsize{Cols: p.Cols, Rows: p.Rows})
	if err != nil {
		return nil, &rpcError{Code: -32000, Message: "pty start failed: " + err.Error()}
	}

	id := r.nextID()
	entry := &ptyEntry{id: id, pty: f, cmd: c}
	r.mu.Lock()
	r.m[id] = entry
	r.mu.Unlock()

	go r.pump(entry)
	go r.wait(entry)

	return map[string]string{"id": id}, nil
}

func (r *ptyRegistry) pump(e *ptyEntry) {
	buf := make([]byte, 32*1024)
	for {
		n, err := e.pty.Read(buf)
		if n > 0 {
			encoded := base64.StdEncoding.EncodeToString(buf[:n])
			r.srv.sendNotification("pty.data", map[string]string{"id": e.id, "data": encoded})
		}
		if err != nil {
			return
		}
	}
}

func (r *ptyRegistry) wait(e *ptyEntry) {
	err := e.cmd.Wait()
	code := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			if status, ok := ee.Sys().(syscall.WaitStatus); ok {
				code = status.ExitStatus()
			} else {
				code = 1
			}
		} else {
			code = 1
		}
	}
	e.mu.Lock()
	e.dead = true
	_ = e.pty.Close()
	e.mu.Unlock()

	r.mu.Lock()
	delete(r.m, e.id)
	r.mu.Unlock()

	r.srv.sendNotification("pty.exit", map[string]interface{}{"id": e.id, "code": code})
}

type ptyWriteParams struct {
	ID   string `json:"id"`
	Data string `json:"data"`
}

func (r *ptyRegistry) handleWrite(params json.RawMessage) (interface{}, *rpcError) {
	var p ptyWriteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params"}
	}
	e := r.get(p.ID)
	if e == nil {
		return nil, &rpcError{Code: -32004, Message: "pty not found"}
	}
	decoded, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil {
		return nil, &rpcError{Code: -32602, Message: "data not base64"}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.dead {
		return map[string]bool{"ok": false}, nil
	}
	if _, err := e.pty.Write(decoded); err != nil {
		if err == io.EOF {
			return map[string]bool{"ok": false}, nil
		}
		return nil, &rpcError{Code: -32000, Message: "write failed: " + err.Error()}
	}
	return map[string]bool{"ok": true}, nil
}

type ptyResizeParams struct {
	ID   string `json:"id"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

func (r *ptyRegistry) handleResize(params json.RawMessage) (interface{}, *rpcError) {
	var p ptyResizeParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params"}
	}
	e := r.get(p.ID)
	if e == nil {
		return nil, &rpcError{Code: -32004, Message: "pty not found"}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.dead {
		return map[string]bool{"ok": false}, nil
	}
	_ = pty.Setsize(e.pty, &pty.Winsize{Cols: p.Cols, Rows: p.Rows})
	return map[string]bool{"ok": true}, nil
}

type ptyKillParams struct {
	ID string `json:"id"`
}

func (r *ptyRegistry) handleKill(params json.RawMessage) (interface{}, *rpcError) {
	var p ptyKillParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params"}
	}
	e := r.get(p.ID)
	if e == nil {
		return map[string]bool{"ok": true}, nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.cmd.Process != nil {
		_ = e.cmd.Process.Kill()
	}
	return map[string]bool{"ok": true}, nil
}

func (r *ptyRegistry) killAll() {
	r.mu.Lock()
	entries := make([]*ptyEntry, 0, len(r.m))
	for _, e := range r.m {
		entries = append(entries, e)
	}
	r.mu.Unlock()
	for _, e := range entries {
		e.mu.Lock()
		if e.cmd.Process != nil {
			_ = e.cmd.Process.Kill()
		}
		e.mu.Unlock()
	}
}

func (r *ptyRegistry) get(id string) *ptyEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.m[id]
}

func (r *ptyRegistry) nextID() string {
	n := atomic.AddUint64(&r.seq, 1)
	return "p" + itoa(n)
}

func itoa(n uint64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func hasEnv(env []string, key string) bool {
	prefix := key + "="
	for _, e := range env {
		if len(e) >= len(prefix) && e[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}
func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	for i, e := range env {
		if strings.HasPrefix(e, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}
func removeEnv(env []string, key string) []string {
	prefix := key + "="
	out := env[:0]
	for _, e := range env {
		if strings.HasPrefix(e, prefix) {
			continue
		}
		out = append(out, e)
	}
	return out
}
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}
func resolveUserShell() string {
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	if s := shellFromPasswd(); s != "" {
		return s
	}
	if _, err := os.Stat("/bin/bash"); err == nil {
		return "/bin/bash"
	}
	return "/bin/sh"
}

func shellFromPasswd() string {
	uid := strconv.Itoa(os.Getuid())
	if out, err := exec.Command("getent", "passwd", uid).Output(); err == nil {
		if shell := parsePasswdLine(string(out)); shell != "" {
			return shell
		}
	}
	if data, err := os.ReadFile("/etc/passwd"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			fields := strings.Split(line, ":")
			if len(fields) >= 7 && fields[2] == uid && fields[6] != "" {
				return fields[6]
			}
		}
	}
	if runtime.GOOS == "darwin" {
		name := os.Getenv("USER")
		if name == "" {
			if u, err := exec.Command("id", "-un").Output(); err == nil {
				name = strings.TrimSpace(string(u))
			}
		}
		if name != "" {
			if out, err := exec.Command("dscl", ".", "-read", "/Users/"+name, "UserShell").Output(); err == nil {
				line := strings.TrimSpace(string(out))
				if idx := strings.Index(line, ":"); idx >= 0 {
					return strings.TrimSpace(line[idx+1:])
				}
			}
		}
	}
	return ""
}

func parsePasswdLine(line string) string {
	line = strings.TrimSpace(line)
	fields := strings.Split(line, ":")
	if len(fields) >= 7 {
		return fields[6]
	}
	return ""
}
