param([string]$InitialDirectory = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# IFileOpenDialog supplies the Explorer folder picker, including address bar,
# search, drive navigation, and new-folder actions, on Windows PowerShell 5.1.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PapergodFolderPicker {
    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes();
        void SetFileTypeIndex();
        void GetFileTypeIndex();
        void Advise();
        void Unadvise();
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder();
        void GetCurrentSelection();
        void SetFileName();
        void GetFileName();
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel();
        void SetFileNameLabel();
        void GetResult(out IShellItem item);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
        void BindToHandler();
        void GetParent();
        void GetDisplayName(uint kind, out IntPtr name);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);

    public static string Choose(string initialDirectory) {
        var dialog = (IFileOpenDialog)new FileOpenDialog();
        IShellItem folder = null;
        IShellItem result = null;
        try {
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | 0x20u | 0x40u | 0x800u); // PICKFOLDERS, FORCEFILESYSTEM, PATHMUSTEXIST
            dialog.SetTitle("Choose a Papergod workspace");
            if (System.IO.Directory.Exists(initialDirectory)) {
                Guid iid = typeof(IShellItem).GUID;
                SHCreateItemFromParsingName(initialDirectory, IntPtr.Zero, ref iid, out folder);
                dialog.SetFolder(folder);
            }
            int status = dialog.Show(IntPtr.Zero);
            if (status == unchecked((int)0x800704C7)) return null;
            Marshal.ThrowExceptionForHR(status);
            dialog.GetResult(out result);
            IntPtr name;
            result.GetDisplayName(0x80058000, out name); // SIGDN_FILESYSPATH
            try { return Marshal.PtrToStringUni(name); }
            finally { Marshal.FreeCoTaskMem(name); }
        } finally {
            if (result != null) Marshal.ReleaseComObject(result);
            if (folder != null) Marshal.ReleaseComObject(folder);
            Marshal.ReleaseComObject(dialog);
        }
    }
}
'@

[PapergodFolderPicker]::Choose($InitialDirectory)
