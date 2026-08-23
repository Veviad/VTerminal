//go:build linux

package main

import (
	"strings"
	"testing"
)

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
