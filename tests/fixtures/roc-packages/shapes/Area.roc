module [of_circle]

import Circle exposing [Circle]

of_circle : Circle -> F64
of_circle = |c| 3.14159 * c.radius * c.radius
