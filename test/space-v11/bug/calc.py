"""验收现场的坏代码：area_of_circle 用了直径当半径。"""
import math


def area_of_circle(radius: float) -> float:
    return math.pi * radius ** 2


def perimeter(radius: float) -> float:
    return 2 * math.pi * radius
