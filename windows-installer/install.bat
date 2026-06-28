@echo off
title Invoice OCR - Installer
echo.
echo  ============================================
echo   Invoice OCR Extractor - Windows Installer
echo  ============================================
echo.
echo  This will set up the Invoice OCR server and
echo  create a Desktop shortcut for one-click launch.
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
