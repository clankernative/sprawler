from shop.core import Model
from . import core
from .core import (Model as CoreModel)

def handle():
    return Model(), core, CoreModel
