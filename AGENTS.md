# Repository Agent Instructions

## 示例

```
  powershell.exe -NoProfile -Command "
  Set-Location 'E:\Code\Blog\BlogBackEnd'
  npm.cmd run check:memory-schema
  "
```

## Calling Windows Node from WSL

Use the native WSL `node`/`npm` by default. Use Windows Node only when the command must reach a service that is available exclusively through Windows `localhost`, requires a Windows-native executable/runtime, or the user explicitly requests the Windows environment.

Never hard-code this repository's Windows path. Resolve the current working directory with `wslpath`, switch directories inside PowerShell, call the Windows executable explicitly, and propagate its exit code:

```bash
WINDOWS_CWD="$(wslpath -w "$PWD")"
powershell.exe -NoProfile -Command "Set-Location '$WINDOWS_CWD'; node.exe <node-args>; exit \$LASTEXITCODE"
```

For package scripts, use `npm.cmd` and put script arguments after `--`:

```bash
WINDOWS_CWD="$(wslpath -w "$PWD")"
powershell.exe -NoProfile -Command "Set-Location '$WINDOWS_CWD'; npm.cmd run <script> -- <script-args>; exit \$LASTEXITCODE"
```

Apply these constraints:

- Do not place passwords, tokens, or full credential-bearing connection strings in the PowerShell command. Let the Windows process load the repository's environment configuration or an explicitly selected untracked environment file.
- WSL environment variables are not assumed to propagate to Windows processes.
- Do not run `npm install`, `pnpm install`, rebuild native dependencies, or otherwise rewrite shared `node_modules` through the alternate OS runtime unless the user explicitly asks; platform-specific optional packages can break the other runtime.
- Using Windows Node changes only the execution environment. It does not authorize migrations, `--apply`, production writes, service control, or other external state changes. Preserve the normal confirmation and environment-isolation requirements for those actions.
- If the dependency is reachable from WSL directly, prefer native WSL Node and avoid this bridge.
