package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"syscall"
)

type execRunParams struct {
	Cmd        string   `json:"cmd"`
	Args       []string `json:"args"`
	Cwd        string   `json:"cwd"`
	Env        []string `json:"env"`
	Stdin      string   `json:"stdin"`
	LoginShell bool     `json:"loginShell"`
}

type execRunResult struct {
	Code   int    `json:"code"`
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
}

func (s *server) handleExec(params json.RawMessage) (interface{}, *rpcError) {
	var p execRunParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params"}
	}
	if p.Cmd == "" {
		return nil, &rpcError{Code: -32602, Message: "cmd is required"}
	}
	runCmd := p.Cmd
	runArgs := p.Args
	if p.LoginShell {
		shellCmd := shellQuote(p.Cmd)
		for _, a := range p.Args {
			shellCmd += " " + shellQuote(a)
		}
		runCmd = resolveUserShell()
		runArgs = []string{"-ilc", "exec " + shellCmd}
	}
	c := exec.Command(runCmd, runArgs...)
	if p.Cwd != "" {
		c.Dir = p.Cwd
	}
	if len(p.Env) > 0 {
		c.Env = append(os.Environ(), p.Env...)
	}
	if p.Stdin != "" {
		decoded, err := base64.StdEncoding.DecodeString(p.Stdin)
		if err != nil {
			return nil, &rpcError{Code: -32602, Message: "stdin not base64"}
		}
		c.Stdin = bytes.NewReader(decoded)
	}
	var stdout, stderr bytes.Buffer
	c.Stdout = &stdout
	c.Stderr = &stderr

	code := 0
	if err := c.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			if status, ok := ee.Sys().(syscall.WaitStatus); ok {
				code = status.ExitStatus()
			} else {
				code = 1
			}
		} else {
			return &execRunResult{
				Code:   -1,
				Stderr: base64.StdEncoding.EncodeToString([]byte(err.Error())),
			}, nil
		}
	}
	return &execRunResult{
		Code:   code,
		Stdout: base64.StdEncoding.EncodeToString(stdout.Bytes()),
		Stderr: base64.StdEncoding.EncodeToString(stderr.Bytes()),
	}, nil
}
