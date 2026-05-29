"""Custom exceptions."""


class AdherenceError(Exception):
    """Base error."""


class ConfigError(AdherenceError):
    pass


class AuthError(AdherenceError):
    pass


class PermissionError_(AdherenceError):
    pass


class ValidationError(AdherenceError):
    pass


class ModelNotFoundError(AdherenceError):
    pass


class DriftDetected(AdherenceError):
    def __init__(self, feature: str, psi: float):
        self.feature = feature
        self.psi = psi
        super().__init__(f"Drift on feature {feature!r} (PSI={psi:.3f})")
