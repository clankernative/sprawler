app [main!] { shapes: "../shapes/main.roc" }

import shapes.Circle
import shapes.Area

main! = |_| Area.of_circle(Circle.new(2.0))
