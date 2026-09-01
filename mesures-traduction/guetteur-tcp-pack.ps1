# Guetteur TCP : releve toute connexion sortante ouverte par un processus Chrome.
# C'est le SEUL moyen de voir le telechargement d'un pack de langue : il est fait
# par le PROCESSUS NAVIGATEUR, pas par la page -- l'onglet Reseau de la page ne le
# voit donc jamais. On note l'heure de premiere apparition de chaque couple IP:port.
param([string]$Sortie, [int]$Secondes = 240)
"# debut " + (Get-Date).ToString("HH:mm:ss.fff") | Set-Content -Encoding utf8 $Sortie
$vus = @{}
$fin = (Get-Date).AddSeconds($Secondes)
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
        Add-Content -Encoding utf8 $Sortie ((Get-Date).ToString("HH:mm:ss.fff") + "`t" + $k)
      }
    }
  }
  Start-Sleep -Milliseconds 200
}
Add-Content -Encoding utf8 $Sortie ("# fin " + (Get-Date).ToString("HH:mm:ss.fff"))
