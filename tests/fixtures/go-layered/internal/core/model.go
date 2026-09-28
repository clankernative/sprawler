package core

type Model struct { ID string }
func Load() Model { return Model{ID: "x"} }
