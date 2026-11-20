package cv.companion

sealed class UiState {
    data object Idle : UiState()
    data object Loading : UiState()
    data class Loaded(val dealCount: Int) : UiState()
    data class Error(val message: String) : UiState()
}
