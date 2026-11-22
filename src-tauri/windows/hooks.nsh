; Crochets de l'installateur de Snapit (tauri.conf.json : bundle > windows > nsis > installerHooks).

; Mise à jour automatique : Snapit lance l'installateur puis se ferme aussitôt. L'installateur démarre avant que
; Snapit et son assistant clavier (snapit.exe --keyhook) aient fini de se fermer : Windows les voit encore en marche,
; ne parvient pas à arrêter des processus déjà en train de se terminer, et l'installation échouait (« Failed to kill
; Snapit »). En mode mise à jour, on attend donc que snapit.exe soit libéré (5 s au plus) avant ce contrôle.
!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
  ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R9 0
    snapit_wait_free:
      ; un exécutable en cours d'exécution ne peut pas être ouvert en écriture
      ClearErrors
      FileOpen $R8 "$INSTDIR\${MAINBINARYNAME}.exe" a
      ${IfNot} ${Errors}
        FileClose $R8
      ${ElseIf} $R9 < 50
        IntOp $R9 $R9 + 1
        Sleep 100
        Goto snapit_wait_free
      ${EndIf}
  ${EndIf}
!macroend
