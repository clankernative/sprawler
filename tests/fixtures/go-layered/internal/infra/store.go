package infra

import "example.com/layered/internal/core"

type Store struct { Value core.Model }
func New() Store { return Store{Value: core.Load()} }
