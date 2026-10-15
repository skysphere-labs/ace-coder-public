package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

func expandPath(p string) string {
	if p == "" {
		return p
	}
	if p == "~" {
		home, err := os.UserHomeDir()
		if err == nil {
			return home
		}
		return p
	}
	if len(p) >= 2 && p[0] == '~' && (p[1] == '/' || p[1] == os.PathSeparator) {
		home, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(home, p[2:])
		}
	}
	return p
}

type fsListParams struct {
	Path string `json:"path"`
}

type fsEntry struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	Size int64  `json:"size"`
}

type fsListResult struct {
	Path     string    `json:"path"`
	Home     string    `json:"home"`
	Entries  []fsEntry `json:"entries"`
	HasGit   bool      `json:"has_git"`
	Parent   string    `json:"parent"`
}

func (s *server) handleFsList(params json.RawMessage) (interface{}, *rpcError) {
	var p fsListParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params"}
	}
	requested := p.Path
	if requested == "" {
		requested = "~"
	}
	dir := expandPath(requested)
	abs, absErr := filepath.Abs(dir)
	if absErr == nil {
		dir = abs
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, &rpcError{Code: -32001, Message: err.Error()}
	}
	out := make([]fsEntry, 0, len(entries))
	hasGit := false
	for _, e := range entries {
		kind := "file"
		if e.IsDir() {
			kind = "dir"
			if e.Name() == ".git" {
				hasGit = true
			}
		}
		var size int64
		if info, err := e.Info(); err == nil {
			size = info.Size()
		}
		out = append(out, fsEntry{Name: e.Name(), Kind: kind, Size: size})
	}
	home, _ := os.UserHomeDir()
	parent := filepath.Dir(dir)
	if parent == dir {
		parent = ""
	}
	return fsListResult{
		Path:    dir,
		Home:    home,
		Entries: out,
		HasGit:  hasGit,
		Parent:  parent,
	}, nil
}

type fsReadParams struct {
	Path string `json:"path"`
}

type fsReadResult struct {
	Bytes string `json:"bytes"`
}

func (s *server) handleFsRead(params json.RawMessage) (interface{}, *rpcError) {
	var p fsReadParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params"}
	}
	data, err := os.ReadFile(expandPath(p.Path))
	if err != nil {
		return nil, &rpcError{Code: -32001, Message: err.Error()}
	}
	return fsReadResult{Bytes: base64.StdEncoding.EncodeToString(data)}, nil
}

type fsWriteParams struct {
	Path  string `json:"path"`
	Bytes string `json:"bytes"`
}

func (s *server) handleFsWrite(params json.RawMessage) (interface{}, *rpcError) {
	var p fsWriteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params"}
	}
	decoded, err := base64.StdEncoding.DecodeString(p.Bytes)
	if err != nil {
		return nil, &rpcError{Code: -32602, Message: "bytes not base64"}
	}
	resolved := expandPath(p.Path)
	if err := os.MkdirAll(filepath.Dir(resolved), 0o755); err != nil {
		return nil, &rpcError{Code: -32001, Message: err.Error()}
	}
	if err := os.WriteFile(resolved, decoded, 0o644); err != nil {
		return nil, &rpcError{Code: -32001, Message: err.Error()}
	}
	return map[string]bool{"ok": true}, nil
}

type fsMkdirParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
}

func (s *server) handleFsMkdir(params json.RawMessage) (interface{}, *rpcError) {
	var p fsMkdirParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params"}
	}
	resolved := expandPath(p.Path)
	var err error
	if p.Recursive {
		err = os.MkdirAll(resolved, 0o755)
	} else {
		err = os.Mkdir(resolved, 0o755)
	}
	if err != nil {
		return nil, &rpcError{Code: -32001, Message: err.Error()}
	}
	return map[string]bool{"ok": true}, nil
}

type fsRemoveParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
}

func (s *server) handleFsRemove(params json.RawMessage) (interface{}, *rpcError) {
	var p fsRemoveParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params"}
	}
	resolved := expandPath(p.Path)
	var err error
	if p.Recursive {
		err = os.RemoveAll(resolved)
	} else {
		err = os.Remove(resolved)
	}
	if err != nil {
		return nil, &rpcError{Code: -32001, Message: err.Error()}
	}
	return map[string]bool{"ok": true}, nil
}

type fsRenameParams struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func (s *server) handleFsRename(params json.RawMessage) (interface{}, *rpcError) {
	var p fsRenameParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params"}
	}
	if err := os.Rename(expandPath(p.From), expandPath(p.To)); err != nil {
		return nil, &rpcError{Code: -32001, Message: err.Error()}
	}
	return map[string]bool{"ok": true}, nil
}

type fsStatParams struct {
	Path string `json:"path"`
}

type fsStatResult struct {
	Exists bool   `json:"exists"`
	Kind   string `json:"kind"`
	Size   int64  `json:"size"`
	MTime  int64  `json:"mtime"`
}

func (s *server) handleFsStat(params json.RawMessage) (interface{}, *rpcError) {
	var p fsStatParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params"}
	}
	info, err := os.Stat(expandPath(p.Path))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fsStatResult{Exists: false}, nil
		}
		return nil, &rpcError{Code: -32001, Message: err.Error()}
	}
	kind := "file"
	if info.IsDir() {
		kind = "dir"
	}
	return fsStatResult{
		Exists: true,
		Kind:   kind,
		Size:   info.Size(),
		MTime:  info.ModTime().Unix(),
	}, nil
}
