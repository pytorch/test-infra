from unittest import TestCase, main
from datetime import time
from rockset_autoscale import get_desired_size_at_time, scale_down_size, scale_up_size

class TestRocksetAutoscale(TestCase):
    def test_wants_to_scale_down_during_scale_down_window(self):
        scale_down_time = time(3, 0, 0)
        scale_up_time = time(15, 0, 0)
        current_time = time(11, 0, 0)
        expected_size = scale_down_size

        desired_size = get_desired_size_at_time(current_time, scale_up_time, scale_down_time)
        self.assertEqual(desired_size, expected_size)

    
    def test_wants_to_scale_up_before_scale_down_window_starts(self):
        scale_down_time = time(3, 0, 0)
        scale_up_time = time(15, 0, 0)
        current_time = time(2, 0, 0)
        expected_size = scale_up_size

        desired_size = get_desired_size_at_time(current_time, scale_up_time, scale_down_time)
        self.assertEqual(desired_size, expected_size)
    

    def test_wants_to_scale_up_after_scale_down_window_ends(self):
        scale_down_time = time(3, 0, 0)
        scale_up_time = time(15, 0, 0)
        current_time = time(20, 0, 0)
        expected_size = scale_up_size

        desired_size = get_desired_size_at_time(current_time, scale_up_time, scale_down_time)
        self.assertEqual(desired_size, expected_size)


if __name__ == "__main__":
    main()