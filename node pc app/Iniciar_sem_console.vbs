' VAGALUN — inicia o nó de PC sem mostrar janela de console (cmd).
' O painel abre sozinho no navegador; o processo fica rodando em
' segundo plano. Pra encerrar, use o Gerenciador de Tarefas e
' finalize "vagalun-pc-node.exe".
Set objShell = CreateObject("WScript.Shell")
strPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
objShell.CurrentDirectory = strPath
objShell.Run """" & strPath & "\dist\vagalun-pc-node.exe""", 0, False
