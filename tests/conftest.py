"""Pytest fixtures."""
import pytest

from adherence_data import SyntheticConfig, generate_events
from adherence_features.engineering import build_training_frame


@pytest.fixture(scope="session")
def tiny_events():
    return generate_events(SyntheticConfig(n_users=80, n_days=14, seed=7))


@pytest.fixture(scope="session")
def tiny_features(tiny_events):
    return build_training_frame(tiny_events)
