$out = Join-Path $PSScriptRoot "tcp-voletB.txt"
"# debut " + (Get-Date).ToString("HH:mm:ss") | Set-Content -Encoding utf8 $out
$vus = @{}
$fin = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $fin) {
  $procs = Get-Process -Name chrome -ErrorAction SilentlyContinue
  if ($procs) {
    $pids = $procs.Id
    $cx = Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {
      $pids -contains $_.OwningProcess -and $_.RemotePort -ne 0 -and
      $_.RemoteAddress -ne '0.0.0.0' -and $_.RemoteAddress -ne '::' -and
      $_.RemoteAddress -ne '127.0.0.1' -and $_.RemoteAddress -ne '::1'
    }
    foreach ($c in $cx) {
      $k = "$($c.RemoteAddress):$($c.RemotePort)"
      if (-not $vus.ContainsKey($k)) {
        $vus[$k] = $true
        Add-Content -Encoding utf8 $out ((Get-Date).ToString("HH:mm:ss") + "`t" + $k)
      }
    }
  }
  Start-Sleep -Milliseconds 250
}
Add-Content -Encoding utf8 $out ("# fin " + (Get-Date).ToString("HH:mm:ss"))
