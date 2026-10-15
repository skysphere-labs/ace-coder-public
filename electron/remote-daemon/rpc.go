package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcNotification struct {
	JSONRPC string      `json:"jsonrpc"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params,omitempty"`
}
type server struct {
	mu       sync.Mutex
	writer   *bufio.Writer
	methods  map[string]methodHandler
	ptys     *ptyRegistry
	shutdown chan struct{}
}

type methodHandler func(params json.RawMessage) (interface{}, *rpcError)

func serve() error {
	s := &server{
		writer:   bufio.NewWriter(os.Stdout),
		methods:  map[string]methodHandler{},
		shutdown: make(chan struct{}),
	}
	s.ptys = newPtyRegistry(s)
	s.registerMethods()

	reader := bufio.NewReaderSize(os.Stdin, 64*1024)
	for {
		body, err := readFrame(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				s.ptys.killAll()
				return nil
			}
			return fmt.Errorf("read frame: %w", err)
		}
		go s.dispatch(body)
	}
}

func readFrame(r *bufio.Reader) ([]byte, error) {
	var contentLength int
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		if strings.HasPrefix(strings.ToLower(line), "content-length:") {
			v := strings.TrimSpace(line[len("content-length:"):])
			n, err := strconv.Atoi(v)
			if err != nil {
				return nil, fmt.Errorf("bad content-length: %w", err)
			}
			contentLength = n
		}
	}
	if contentLength <= 0 {
		return nil, fmt.Errorf("missing content-length")
	}
	buf := make([]byte, contentLength)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func (s *server) dispatch(body []byte) {
	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		s.sendError(nil, -32700, "parse error")
		return
	}
	handler, ok := s.methods[req.Method]
	if !ok {
		s.sendError(req.ID, -32601, "method not found: "+req.Method)
		return
	}
	result, rpcErr := handler(req.Params)
	if req.ID == nil {
		return
	}
	s.sendResponse(req.ID, result, rpcErr)
}

func (s *server) sendResponse(id json.RawMessage, result interface{}, rpcErr *rpcError) {
	resp := rpcResponse{JSONRPC: "2.0", ID: id, Result: result, Error: rpcErr}
	s.writeMessage(resp)
}

func (s *server) sendError(id json.RawMessage, code int, msg string) {
	s.sendResponse(id, nil, &rpcError{Code: code, Message: msg})
}

func (s *server) sendNotification(method string, params interface{}) {
	note := rpcNotification{JSONRPC: "2.0", Method: method, Params: params}
	s.writeMessage(note)
}

func (s *server) writeMessage(payload interface{}) {
	body, err := json.Marshal(payload)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ace-coder-daemon: marshal failed:", err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	fmt.Fprintf(s.writer, "Content-Length: %d\r\n\r\n", len(body))
	s.writer.Write(body)
	s.writer.Flush()
}

func (s *server) registerMethods() {
	s.methods["version"] = s.handleVersion
	s.methods["pty.start"] = s.ptys.handleStart
	s.methods["pty.write"] = s.ptys.handleWrite
	s.methods["pty.resize"] = s.ptys.handleResize
	s.methods["pty.kill"] = s.ptys.handleKill
	s.methods["exec.run"] = s.handleExec
	s.methods["fs.list"] = s.handleFsList
	s.methods["fs.read"] = s.handleFsRead
	s.methods["fs.write"] = s.handleFsWrite
	s.methods["fs.mkdir"] = s.handleFsMkdir
	s.methods["fs.remove"] = s.handleFsRemove
	s.methods["fs.rename"] = s.handleFsRename
	s.methods["fs.stat"] = s.handleFsStat
}

func (s *server) handleVersion(_ json.RawMessage) (interface{}, *rpcError) {
	return map[string]string{
		"protocol":       protocolVersion,
		"daemon_version": daemonVersion,
	}, nil
}
