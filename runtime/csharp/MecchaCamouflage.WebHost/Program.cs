using MecchaCamouflage.Controller;

namespace MecchaCamouflage.WebHost;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var form = new MainForm(new HostSession(VersionInfo.Current));
        Application.Run(form);
    }
}
