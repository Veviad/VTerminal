//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMain makes the test binary behave like the bundled relay when selfTest
// re-executes it in probe mode. Without this, the child recursively runs the
// complete test suite until it exhausts the process limit.
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "probe" {
		if err := probe(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestProxyEnvironmentReplacesInheritedValues(t *testing.T) {
	got := withProxyEnvironment(
		[]string{"PATH=/usr/bin", "HTTP_PROXY=http://untrusted", "NO_PROXY=*"},
		"http://127.0.0.1:1234",
		"socks5h://127.0.0.1:1234",
	)
	joined := strings.Join(got, "\n")
	if strings.Contains(joined, "untrusted") || strings.Contains(joined, "NO_PROXY=*") {
		t.Fatalf("inherited proxy bypass survived: %s", joined)
	}
	for _, expected := range []string{
		"PATH=/usr/bin",
		"HTTP_PROXY=http://127.0.0.1:1234",
		"ALL_PROXY=socks5h://127.0.0.1:1234",
		"NO_PROXY=",
	} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing %q in %s", expected, joined)
		}
	}
}

func TestSeccompSelfTest(t *testing.T) {
	if err := selfTest(); err != nil {
		t.Fatal(err)
	}
}

func TestCurrentExecutableIsAbsolute(t *testing.T) {
	executable, err := currentExecutable()
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(executable) {
		t.Fatalf("relay executable is not absolute: %q", executable)
	}
}

func TestResolveCommandCanonicalizesAnExecutable(t *testing.T) {
	executable, err := resolveCommand("sh")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(executable) {
		t.Fatalf("MCP executable is not absolute: %q", executable)
	}
	if info, err := os.Stat(executable); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("MCP executable is not a regular file: %q (%v)", executable, err)
	}
}
