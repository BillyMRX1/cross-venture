package cv.companion

import cv.core.GraphCounts

sealed class UiState {
    data object Idle : UiState()
    data object Loading : UiState()
    data class Loaded(val counts: GraphCounts) : UiState()
    data class Error(val message: String) : UiState()
}
