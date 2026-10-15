package main

import (
	"fmt"
	"os"
)

const (
	protocolVersion = "1"
	daemonVersion   = "0.5.0"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		if err := serve(); err != nil {
			fmt.Fprintln(os.Stderr, "ace-coder-daemon: serve failed:", err)
			os.Exit(1)
		}
	case "version":
		fmt.Println(daemonVersion)
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: ace-coder-daemon serve --stdio | ace-coder-daemon version")
}
