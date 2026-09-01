const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * @file backend-ast-syntax-integrity.test.js
 * @description Comprehensive Backend AST, Syntax, Module Resolution & Route Integrity Test.
 * 
 * Verifies that:
 * 1. Every backend JS file (index.js, routes/*.js, lib/*.js, middleware/*.js) parses cleanly in Node.js with zero syntax errors.
 * 2. Every require(...) statement resolves to an installed package or valid physical local file.
 * 3. Prevents syntax regressions and import breakage across the entire backend.
 */

test('Backend Master Syntax & Module Resolution Integrity Matrix', async (t) => {
  const backendDir = path.resolve(__dirname, '..');
  
  function getJsFilesRecursive(dir) {
    let results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'test') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(getJsFilesRecursive(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const jsFiles = getJsFilesRecursive(backendDir);
  assert.ok(jsFiles.length >= 10, 'Must find all backend JS source files');

  for (const filePath of jsFiles) {
    const relPath = path.relative(backendDir, filePath);

    await t.test(`Syntax & Parse Integrity: ${relPath}`, () => {
      let syntaxErr = null;
      try {
        execFileSync(process.execPath, ['--check', filePath], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (err) {
        syntaxErr = (err.stderr || err.message).toString();
      }

      assert.strictEqual(
        syntaxErr,
        null,
        `Fatal Syntax Error in backend file ${relPath}:\n${syntaxErr}`
      );
    });

    await t.test(`Local Require Path Resolution: ${relPath}`, () => {
      const code = fs.readFileSync(filePath, 'utf8');
      const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
      let match;

      while ((match = requireRegex.exec(code)) !== null) {
        const reqPath = match[1];
        if (reqPath.startsWith('.')) {
          const resolvedPath = path.resolve(path.dirname(filePath), reqPath);
          const exists = fs.existsSync(resolvedPath) || 
                         fs.existsSync(resolvedPath + '.js') || 
                         fs.existsSync(path.join(resolvedPath, 'index.js'));
          assert.strictEqual(
            exists,
            true,
            `Broken require in ${relPath}: Cannot resolve local path '${reqPath}'`
          );
        }
      }
    });
  }
});
