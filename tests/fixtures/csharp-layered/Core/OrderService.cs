namespace Core;

public class OrderService(IOrderRepository repository)
{
    public Order Create(decimal total)
    {
        var order = new Order { Total = total };
        repository.Add(order);
        return order;
    }
}
