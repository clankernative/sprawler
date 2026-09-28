using Core;

namespace Infra;

public class OrderRepository(ShopDb db) : IOrderRepository
{
    public void Add(Order order) => db.Orders.Add(order);
}
