using Api.Controllers;

namespace Api;

// Deliberate finding: inner-knows-edge (a model depends on a controller).
public record OrderView(int Id)
{
    public static string Route => typeof(OrdersController).Name;
}
