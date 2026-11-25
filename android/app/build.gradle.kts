plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "cv.companion"
    compileSdk = 36

    defaultConfig {
        applicationId = "cv.companion"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        // Firebase connection config is injected at release time by the owner
        // (google-services or these placeholders replaced out-of-band).
        // Never commit real API keys here.
        buildConfigField("String", "FB_API_KEY", "\"REPLACE_AT_RELEASE\"")
        buildConfigField("String", "FB_PROJECT_ID", "\"REPLACE_AT_RELEASE\"")
        buildConfigField("String", "FB_APP_ID", "\"REPLACE_AT_RELEASE\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":core"))

    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    implementation(platform("com.google.firebase:firebase-bom:33.5.1"))
    implementation("com.google.firebase:firebase-auth-ktx")
    implementation("com.google.firebase:firebase-firestore-ktx")

    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
