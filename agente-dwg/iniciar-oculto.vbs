' Inicia o agente DWG sem abrir janela (usado pelo atalho de inicialização do Windows).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = pasta
sh.Run "node --env-file=.env agente.mjs", 0, False
