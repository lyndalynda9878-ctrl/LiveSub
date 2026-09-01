# VOLET B -- couper le reseau de Chrome sans droits administrateur.
#
# L'adaptateur ne peut pas etre desactive (netsh wlan renvoie deja « erreur 5 :
# requiert une elevation »). On passe donc par le PROXY SYSTEME, qui vit dans
# HKCU -- donc modifiable par l'utilisateur courant. Chrome le lit et l'applique
# a TOUT son reseau, processus navigateur compris : ce n'est pas une emulation
# de page, c'est la couche que le composant de mise a jour emprunte lui aussi.
#
# ⚠️ La restauration est faite par un TIMER, pas par l'appelant : meme si tout
# le reste echoue, le reseau revient au bout de $Secondes.
param([int]$Secondes = 75)
$k = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
$avant = Get-ItemProperty $k
$enableAvant = $avant.ProxyEnable
$serverAvant = $avant.ProxyServer

"# etat AVANT : ProxyEnable=$enableAvant ProxyServer='$serverAvant'"
try {
  Set-ItemProperty $k -Name ProxyServer -Value "127.0.0.1:1" -Type String
  Set-ItemProperty $k -Name ProxyEnable -Value 1 -Type DWord
  "# COUPE a " + (Get-Date).ToString("HH:mm:ss.fff")
  Start-Sleep -Seconds $Secondes
} finally {
  if ($null -eq $enableAvant) { Remove-ItemProperty $k -Name ProxyEnable -ErrorAction SilentlyContinue }
  else { Set-ItemProperty $k -Name ProxyEnable -Value $enableAvant -Type DWord }
  if ([string]::IsNullOrEmpty($serverAvant)) { Set-ItemProperty $k -Name ProxyServer -Value "" -Type String }
  else { Set-ItemProperty $k -Name ProxyServer -Value $serverAvant -Type String }
  "# RETABLI a " + (Get-Date).ToString("HH:mm:ss.fff")
}
