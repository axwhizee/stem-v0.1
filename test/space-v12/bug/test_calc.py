import math
from calc import area_of_circle, perimeter

assert abs(area_of_circle(1) - math.pi) < 1e-9, "area_of_circle(1) 应约等于 pi"
assert abs(perimeter(1) - 2 * math.pi) < 1e-9
print("ALL GREEN")
