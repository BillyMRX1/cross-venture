package cv.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import cv.core.Pairing
import cv.core.VaultCrypto
import cv.core.summarizeGraph
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Placeholder Firebase config: real values are injected by the owner at
        // release time. Network fetch fails gracefully until then; nothing here
        // ever holds credentials in git.
        if (FirebaseApp.getApps(this).isEmpty()) {
            FirebaseApp.initializeApp(
                this,
                FirebaseOptions.Builder()
                    .setApiKey(BuildConfig.FB_API_KEY)
                    .setProjectId(BuildConfig.FB_PROJECT_ID)
                    .setApplicationId(BuildConfig.FB_APP_ID)
                    .build(),
            )
        }
        setContent { MaterialTheme { Surface { CompanionScreen() } } }
    }
}

@Composable
fun CompanionScreen() {
    var pairing by remember { mutableStateOf("") }
    var state by remember { mutableStateOf<UiState>(UiState.Idle) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Deal Guardian Companion", style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(
            value = pairing,
            onValueChange = { pairing = it },
            label = { Text("Pairing string from the web app") },
            singleLine = false,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
            modifier = Modifier.fillMaxWidth(),
        )
        Button(onClick = {
            state = UiState.Loading
            scope.launch {
                state = runCatching { loadWorkspace(pairing) }
                    .getOrElse { e -> UiState.Error(e.message ?: "load failed") }
            }
        }) { Text("Load") }
        when (val s = state) {
            UiState.Idle -> Text("Idle.")
            UiState.Loading -> Text("Loading…")
            is UiState.Loaded -> Text("Loaded ${s.counts.ventures} venture(s), ${s.counts.products} product(s). Decryption is local; raw content never logged.")
            is UiState.Error -> Text("Error: ${s.message}")
        }
    }
}

private suspend fun loadWorkspace(pairingString: String): UiState {
    val parsed = Pairing.parse(pairingString)
    val key = VaultCrypto.importKeyJwk(parsed.jwkJson())
    val doc = withContext(Dispatchers.IO) {
        // Firestore rules require an authenticated (anonymous) reader (F3).
        val auth = FirebaseAuth.getInstance()
        if (auth.currentUser == null) {
            Tasks.await(auth.signInAnonymously())
        }
        Tasks.await(
            FirebaseFirestore.getInstance()
                .collection("workspaces")
                .document(parsed.wsId)
                .get(),
        )
    }
    if (!doc.exists()) return UiState.Error("workspace not found")
    val iv = doc.getString("iv") ?: return UiState.Error("document has no iv")
    val cipher = doc.getString("cipher") ?: return UiState.Error("document has no cipher")
    val plain = VaultCrypto.decryptJson(key, iv, cipher)
    // Only counts are shown/logged — decrypted content is never rendered raw here.
    return UiState.Loaded(summarizeGraph(plain))
}
