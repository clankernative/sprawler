// Minimal stand-ins so the fixture needs no NuGet restore; roles are inferred from these names.
namespace Microsoft.EntityFrameworkCore
{
    public class DbContext { }
    public class DbSet<T> : List<T> { }
}
