# @implements spec/feature/danger-command-approval.md CC-PW-02/03/04
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not [System.Environment]::UserInteractive) { exit 1 }
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$form = New-Object System.Windows.Forms.Form
$timer = New-Object System.Windows.Forms.Timer
try {
    $form.Text = 'Cc WARNING - Git push authorization'
    $form.Size = New-Object System.Drawing.Size(850, 650)
    $form.StartPosition = 'CenterScreen'
    $form.TopMost = $true
    $form.MinimizeBox = $false
    $form.MaximizeBox = $false
    $text = New-Object System.Windows.Forms.TextBox
    $text.Multiline = $true
    $text.ReadOnly = $true
    $text.ScrollBars = 'Both'
    $text.WordWrap = $false
    $text.Dock = 'Fill'
    $text.Text = [string]$payload.text
    $panel = New-Object System.Windows.Forms.FlowLayoutPanel
    $panel.Dock = 'Bottom'
    $panel.Height = 90
    $check = New-Object System.Windows.Forms.CheckBox
    $check.Text = 'I understand the exact target and the risk of replacing public history.'
    $check.Width = 800
    $allow = New-Object System.Windows.Forms.Button
    $allow.Text = 'Allow this push ONCE'
    $allow.Width = 220
    $allow.Enabled = $false
    $deny = New-Object System.Windows.Forms.Button
    $deny.Text = 'Deny'
    $deny.Width = 150
    $deny.DialogResult = 'Cancel'
    $check.Add_CheckedChanged({ $allow.Enabled = $check.Checked })
    $allow.Add_Click({ if ($check.Checked) { $form.DialogResult = 'OK'; $form.Close() } })
    $panel.Controls.AddRange(@($check, $deny, $allow))
    $form.Controls.Add($text)
    $form.Controls.Add($panel)
    $form.AcceptButton = $deny
    $form.CancelButton = $deny
    $timer.Interval = 90000
    $timer.Add_Tick({ $form.DialogResult = 'Cancel'; $form.Close() })
    $timer.Start()
    if ($form.ShowDialog() -eq 'OK' -and $check.Checked) { [Console]::WriteLine('approved') }
    else { [Console]::WriteLine('denied') }
} finally {
    $timer.Stop()
    $timer.Dispose()
    $form.Dispose()
}
