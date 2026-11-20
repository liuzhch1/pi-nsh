import process from "process";

const POWERSHELL_SCRIPT = String.raw`
$source = @"
using System;
using System.Runtime.InteropServices;

public static class NshFolderPicker
{
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    private static void EnableDpiAwareness()
    {
        try
        {
            SetThreadDpiAwarenessContext(new IntPtr(-4));
        }
        catch
        {
            try
            {
                SetProcessDPIAware();
            }
            catch
            {
            }
        }
    }

    public static string Pick(string title)
    {
        EnableDpiAwareness();
        var dialog = (IFileOpenDialog)new FileOpenDialog();
        uint options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | 0x00000020u | 0x00000040u | 0x00000800u);
        dialog.SetTitle(title);
        if (dialog.Show(IntPtr.Zero) != 0) return null;

        IShellItem result;
        dialog.GetResult(out result);
        string path;
        result.GetDisplayName(0x80058000u, out path);
        return path;
    }
}
"@
Add-Type -TypeDefinition $source -Language CSharp
[NshFolderPicker]::Pick('Choose a project folder for pi')
`;

export async function chooseWindowsFolder(): Promise<string | null> {
  const encoded = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");
  const result = await process.run(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    { timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "The folder chooser did not open.");
  }
  return result.stdout.trim() || null;
}
