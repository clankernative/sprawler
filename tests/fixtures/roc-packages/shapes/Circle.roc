module [Circle, new]

Circle : { radius : F64 }

new : F64 -> Circle
new = |radius| { radius }
