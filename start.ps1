$router = Start-Process cmd -PassThru -WorkingDirectory 'D:\LocalAI\claude-proxy' -ArgumentList '/k', 'node router.js'
$llama  = Start-Process powershell -PassThru -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', 'D:\LocalAI\llama.cpp\start-llama.ps1'

Write-Host 'Router and llama-server are starting in their own windows.'
Write-Host 'Use Claude Code as normal. Press Enter here to stop both.'
Read-Host | Out-Null

taskkill /T /F /PID $llama.Id  | Out-Null
taskkill /T /F /PID $router.Id | Out-Null