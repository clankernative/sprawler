use shop_core::Order;

pub fn print(o: &Order) {
    println!("{}", o.total);
}
