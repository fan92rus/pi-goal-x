' Hidden launcher for the hourly pi-goal-x upstream sync.
' The scheduled task runs this via wscript //B //Nologo; the window style 0
' cmd shim keeps node.exe invisible in the interactive session. Waits for the
' sync and propagates its exit code so Last Task Result stays meaningful.
Option Explicit
Dim sh, rc
Set sh = WScript.CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\Documents\Repositories\goal-x\pi-goal-x"
rc = sh.Run("""C:\Windows\System32\cmd.exe"" /c ""D:\Documents\Repositories\goal-x\pi-goal-x\scripts\upstream-sync-hidden.cmd""", 0, True)
WScript.Quit rc
