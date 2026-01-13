#!/bin/bash
# Test Git API path validation

echo "Testing Git API path validation..."
echo ""

# Test 1: Valid path (home directory)
echo "Test 1: Valid path (HOME directory)"
curl -s "http://localhost:4174/api/git/status?cwd=$HOME" | jq -r '.error // "✓ Success"'
echo ""

# Test 2: Forbidden path (/etc)
echo "Test 2: Forbidden path (/etc)"
curl -s "http://localhost:4174/api/git/status?cwd=/etc" | jq -r '.error // "✗ FAIL: Should be forbidden"'
echo ""

# Test 3: Forbidden path (/var)
echo "Test 3: Forbidden path (/var)"
curl -s "http://localhost:4174/api/git/status?cwd=/var" | jq -r '.error // "✗ FAIL: Should be forbidden"'
echo ""

# Test 4: Path traversal attempt
echo "Test 4: Path traversal attempt (../../../etc)"
curl -s "http://localhost:4174/api/git/status?cwd=$HOME/../../../etc" | jq -r '.error // "✗ FAIL: Should be forbidden"'
echo ""

# Test 5: Symlink to forbidden path (if exists)
echo "Test 5: Testing realpath validation"
if [ -L "$HOME/test-symlink-etc" ]; then
  curl -s "http://localhost:4174/api/git/status?cwd=$HOME/test-symlink-etc" | jq -r '.error // "✗ FAIL: Should be forbidden"'
else
  echo "Skipped (no test symlink)"
fi
echo ""

echo "All tests completed!"
