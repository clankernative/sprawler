#[test]
fn makes_an_order() {
    assert_eq!(shop_core::Order::new(2).total, 2);
}
