//go:build linux

// vterminal-mcp-relay bridges a bubblewrap network namespace to VTerminal's
// authenticated, domain-filtering proxy on the Windows host. It also supervises
// the MCP server and installs a seccomp filter before exec.
package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const (
	prSetNoNewPrivs   = 38
	prSetSeccomp      = 22
	seccompModeFilter = 2
	auditArchX8664    = 0xc000003e
	seccompRetKill    = 0x80000000
	seccompRetErrno   = 0x00050000
	seccompRetAllow   = 0x7fff0000
	bpfLd             = 0x00
	bpfW              = 0x00
	bpfAbs            = 0x20
	bpfJmp            = 0x05
	bpfJeq            = 0x10
	bpfK              = 0x00
	bpfRet            = 0x06
)

type sockFilter struct {
	code uint16
	jt   uint8
	jf   uint8
	k    uint32
}

type sockFprog struct {
	length uint16
	filter *sockFilter
}

func main() {
	if len(os.Args) < 2 {
		fatal("expected bridge, run, exec, self-test, host, or probe")
	}
	var err error
	switch os.Args[1] {
	case "bridge":
		err = bridge(os.Args[2:])
	case "run":
		err = run(os.Args[2:])
	case "exec":
		err = filteredExec(os.Args[2:])
	case "self-test":
		err = selfTest()
	case "host":
		var host string
		host, err = windowsHost()
		if err == nil {
			fmt.Println(host)
		}
	case "probe":
		err = probe()
	default:
		err = fmt.Errorf("unknown mode %q", os.Args[1])
	}
	if err != nil {
		fatal(err.Error())
	}
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, "vterminal-mcp-relay:", message)
	os.Exit(1)
}

func bridge(args []string) error {
	flags := flag.NewFlagSet("bridge", flag.ContinueOnError)
	socket := flags.String("socket", "", "Unix socket path")
	host := flags.String("host", "", "Windows host address")
	port := flags.Int("port", 0, "Windows proxy port")
	token := flags.String("token", "", "per-launch proxy token")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *socket == "" || *port < 1 || *port > 65535 || len(*token) != 36 {
		return errors.New("bridge needs a socket, port, and 36-byte launch token")
	}
	if *host == "" {
		var err error
		*host, err = windowsHost()
		if err != nil {
			return err
		}
	}
	_ = os.Remove(*socket)
	listener, err := net.Listen("unix", *socket)
	if err != nil {
		return fmt.Errorf("listen on relay socket: %w", err)
	}
	defer listener.Close()
	defer os.Remove(*socket)
	if err := os.Chmod(*socket, 0o600); err != nil {
		return fmt.Errorf("secure relay socket: %w", err)
	}
	// The Windows parent deliberately holds stdin open. Closing or killing it
	// tears down the bridge and removes the socket even after an app crash.
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		_ = listener.Close()
	}()
	for {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			if errors.Is(acceptErr, net.ErrClosed) {
				return nil
			}
			return acceptErr
		}
		go func(downstream net.Conn) {
			upstream, dialErr := net.Dial("tcp", net.JoinHostPort(*host, strconv.Itoa(*port)))
			if dialErr != nil {
				_ = downstream.Close()
				return
			}
			if _, writeErr := io.WriteString(upstream, *token); writeErr != nil {
				_ = upstream.Close()
				_ = downstream.Close()
				return
			}
			relay(downstream, upstream)
		}(connection)
	}
}

func windowsHost() (string, error) {
	file, err := os.Open("/etc/resolv.conf")
	if err != nil {
		return "", fmt.Errorf("open /etc/resolv.conf: %w", err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && fields[0] == "nameserver" && net.ParseIP(fields[1]) != nil {
			return fields[1], nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", errors.New("could not resolve the Windows host from /etc/resolv.conf")
}

func run(args []string) error {
	flags := flag.NewFlagSet("run", flag.ContinueOnError)
	socket := flags.String("socket", "", "mounted bridge socket")
	if err := flags.Parse(args); err != nil {
		return err
	}
	command := flags.Args()
	if *socket == "" || len(command) == 0 {
		return errors.New("run needs a socket and command array")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen inside sandbox: %w", err)
	}
	defer listener.Close()
	go func() {
		for {
			downstream, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func(connection net.Conn) {
				upstream, dialErr := net.Dial("unix", *socket)
				if dialErr != nil {
					_ = connection.Close()
					return
				}
				relay(connection, upstream)
			}(downstream)
		}
	}()
	proxy := "http://" + listener.Addr().String()
	socks := "socks5h://" + listener.Addr().String()
	childArgs := append([]string{"exec", "--"}, command...)
	executable, err := currentExecutable()
	if err != nil {
		return err
	}
	// The executable comes from os.Executable, arguments remain an array, and
	// no shell parses them. Re-execution is required to install seccomp in the
	// child without applying it to this supervisor.
	child := exec.Command(executable, childArgs...) // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command, go_subproc_rule-subproc
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	child.Env = withProxyEnvironment(os.Environ(), proxy, socks)
	if err := child.Start(); err != nil {
		return fmt.Errorf("start MCP command: %w", err)
	}
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	go func() {
		for received := range signals {
			_ = child.Process.Signal(received)
		}
	}()
	return child.Wait()
}

func withProxyEnvironment(environment []string, httpProxy, socksProxy string) []string {
	blocked := map[string]bool{
		"HTTP_PROXY": true, "HTTPS_PROXY": true, "http_proxy": true, "https_proxy": true,
		"ALL_PROXY": true, "all_proxy": true, "NO_PROXY": true, "no_proxy": true,
	}
	result := make([]string, 0, len(environment)+8)
	for _, entry := range environment {
		name, _, _ := strings.Cut(entry, "=")
		if !blocked[name] {
			result = append(result, entry)
		}
	}
	return append(result,
		"HTTP_PROXY="+httpProxy, "HTTPS_PROXY="+httpProxy,
		"http_proxy="+httpProxy, "https_proxy="+httpProxy,
		"ALL_PROXY="+socksProxy, "all_proxy="+socksProxy,
		"NO_PROXY=", "no_proxy=",
	)
}

func filteredExec(args []string) error {
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	if len(args) == 0 {
		return errors.New("exec needs a command array")
	}
	if err := installSeccomp(); err != nil {
		return err
	}
	path, err := resolveCommand(args[0])
	if err != nil {
		return err
	}
	// Executing a user-configured MCP command is this relay's purpose. It runs
	// only after bubblewrap and seccomp are active, uses a canonical executable,
	// passes arguments without a shell, and inherits the already-cleared env.
	return syscall.Exec(path, args, os.Environ()) // nosemgrep: go.lang.security.audit.dangerous-syscall-exec.dangerous-syscall-exec
}

func resolveCommand(name string) (string, error) {
	path, err := exec.LookPath(name)
	if err != nil {
		return "", err
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve MCP executable: %w", err)
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("canonicalize MCP executable: %w", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("inspect MCP executable: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return "", errors.New("MCP executable must be a regular executable file")
	}
	return path, nil
}

func installSeccomp() error {
	blocked := []uint32{
		101,      // ptrace
		155,      // pivot_root
		165, 166, // mount, umount2
		167, 168, 169, // swapon, swapoff, reboot
		175, 176, // init_module, delete_module
		246,           // kexec_load
		248, 249, 250, // add_key, request_key, keyctl
		272, // unshare
		298, // perf_event_open
		304, // open_by_handle_at
		308, // setns
		313, // finit_module
		321, // bpf
		323, // userfaultfd
	}
	filter := []sockFilter{
		{code: bpfLd | bpfW | bpfAbs, k: 4},
		{code: bpfJmp | bpfJeq | bpfK, jt: 1, k: auditArchX8664},
		{code: bpfRet | bpfK, k: seccompRetKill},
		{code: bpfLd | bpfW | bpfAbs, k: 0},
	}
	for _, number := range blocked {
		filter = append(filter,
			sockFilter{code: bpfJmp | bpfJeq | bpfK, jf: 1, k: number},
			sockFilter{code: bpfRet | bpfK, k: seccompRetErrno | uint32(syscall.EPERM)},
		)
	}
	filter = append(filter, sockFilter{code: bpfRet | bpfK, k: seccompRetAllow})
	program := sockFprog{length: uint16(len(filter)), filter: &filter[0]}
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0); errno != 0 {
		return fmt.Errorf("PR_SET_NO_NEW_PRIVS: %w", errno)
	}
	// prctl's seccomp ABI accepts a pointer to the immutable BPF program. The
	// slice remains live for the duration of this synchronous syscall and its
	// length is checked by the kernel before the filter is copied.
	programPointer := uintptr(unsafe.Pointer(&program)) // nosemgrep: go.lang.security.audit.unsafe.use-of-unsafe-block, go_unsafe_rule-unsafe
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetSeccomp, seccompModeFilter, programPointer); errno != 0 {
		return fmt.Errorf("PR_SET_SECCOMP: %w", errno)
	}
	return nil
}

func selfTest() error {
	executable, err := currentExecutable()
	if err != nil {
		return err
	}
	// os.Executable provides the exact current relay; no caller input or PATH
	// lookup controls this command.
	command := exec.Command(executable, "probe") // nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command, go_subproc_rule-subproc
	command.Stdout = io.Discard
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("seccomp probe failed: %w", err)
	}
	return nil
}

// currentExecutable resolves the running relay through the operating system.
// os.Args[0] is caller-controlled and may be a relative path or a different
// executable found through PATH, which is unsafe for the privileged supervisor.
func currentExecutable() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve relay executable: %w", err)
	}
	if !filepath.IsAbs(executable) {
		return "", errors.New("resolved relay executable is not an absolute path")
	}
	return executable, nil
}

func probe() error {
	if err := installSeccomp(); err != nil {
		return err
	}
	_, _, errno := syscall.RawSyscall(syscall.SYS_UNSHARE, uintptr(syscall.CLONE_NEWUSER), 0, 0)
	if errno != syscall.EPERM {
		return fmt.Errorf("seccomp did not deny unshare: %v", errno)
	}
	return nil
}

func relay(left, right net.Conn) {
	defer left.Close()
	defer right.Close()
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(left, right)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(right, left)
		done <- struct{}{}
	}()
	<-done
}
