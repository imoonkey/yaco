# Kotlin/Android house style

- No force-unwrap `!!` — use `?.`, Elvis `?:`, or a checked branch.
- No `GlobalScope` — launch in `viewModelScope` / `lifecycleScope` so work cancels with its owner.
- No static/long-lived `Context` references — they leak the Activity.
- UI off the collector thread: `repeatOnLifecycle(STARTED)` for `Flow` collection; `withContext(Dispatchers.IO)` for blocking work.
- Never swallow: `catch (e: Exception) {}` is always wrong. Catch a specific type, log with context, or re-throw.

## Canonical shapes

Collect a `Flow` scoped to lifecycle — the outer `lifecycleScope.launch` and the inner `repeatOnLifecycle(STARTED)` are both required; collecting without the inner block keeps running in the background:

```kotlin
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.state.collect { }
    }
}
```

Expose ViewModel state as a private mutable `MutableStateFlow` with a public read-only `asStateFlow()`; mutate through `update`:

```kotlin
private val _state = MutableStateFlow(initialState)
val state: StateFlow<UiState> = _state.asStateFlow()

fun updateState(action: Action) {
    _state.update { it.reduce(action) }
}
```

Model success/failure as a sealed result, not nullables or exceptions across boundaries:

```kotlin
sealed class Result<T> {
    data class Success<T>(val data: T) : Result<T>()
    data class Error<T>(val error: Throwable) : Result<T>()
}
```
