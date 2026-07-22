# V6 激进科技增强版定时推送脚本 — 每个交易日14:30自动分析基金并推送钉钉
# 使用方法: 右键PowerShell以管理员身份运行 → 粘贴执行

$projectDir = "C:\Users\丁潘延\stock-fund-advisor"
$nodeExe = "C:\Program Files\nodejs\node.exe"

if (-not (Test-Path $nodeExe)) {
    $nodeExe = "C:\Users\丁潘延\.workbuddy\binaries\node\versions\22.22.2\node.exe"
}

# 删除旧任务
foreach ($name in @("FundAdvisorV3","FundAdvisorV4","FundAdvisorV5","FundAdvisorV6")) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($t) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; Write-Host "已删除$name" }
}

# 创建动作: 每日14:30运行 V6 激进科技增强版并推送钉钉
$action = New-ScheduledTaskAction `
    -Execute $nodeExe `
    -Argument "main.js --aggressive --ding" `
    -WorkingDirectory $projectDir

# 创建触发器: 周一~五 14:30
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "14:30"

# 设置
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask `
    -TaskName "FundAdvisorV6" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "V6激进科技增强版每日14:30(动量轮动+趋势择时+金字塔加仓+ATR动态止损)推送钉钉"

Write-Host ""
Write-Host "============================================"
Write-Host "  V6 激进科技增强版定时任务已创建!"
Write-Host "  时间: 每个交易日 14:30"
Write-Host "  逻辑: 动量轮动 + 趋势择时 + 金字塔加仓"
Write-Host "        + ATR动态止损 + 移动止盈 + 杠铃现金"
Write-Host "  输出: 纯操作指令 推送钉钉"
Write-Host "============================================"
