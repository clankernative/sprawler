using Core;
using Microsoft.EntityFrameworkCore;

namespace Infra;

public class ShopDb : DbContext
{
    public DbSet<Order> Orders { get; set; } = new();
}
