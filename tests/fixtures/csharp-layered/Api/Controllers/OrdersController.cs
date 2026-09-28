using Core;
using Infra;
using Microsoft.AspNetCore.Mvc;

namespace Api.Controllers;

// Deliberate finding: endpoint-to-db (controller uses the DbContext directly).
[ApiController]
[Route("orders")]
public class OrdersController(OrderService service, ShopDb db) : ControllerBase
{
    [HttpPost]
    public IActionResult Create(CreateOrderRequest request) => Ok(service.Create(request.Total));

    [HttpGet]
    public IActionResult Count() => Ok(db.Orders);
}
