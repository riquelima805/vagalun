plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.decentstorage.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.decentstorage.app"
        minSdk = 26 // precisa de 26+ por causa de NsdManager/APIs de crypto usadas
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-mvp"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    
    // Voltando ao padrão seguro para o Jetpack Compose
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
}

dependencies {
    // 🛡️ O BOM força todas as bibliotecas a usarem o Kotlin 1.9.0, evitando erros de metadata
    implementation(platform("org.jetbrains.kotlin:kotlin-bom:1.9.0"))

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.compose.material3:material3:1.2.1")
    implementation("androidx.compose.ui:ui:1.6.8")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Material Design para o Manifest
    implementation("com.google.android.material:material:1.12.0")

    // Solana — Atualizado para 0.8.2 (Igual ao Adla)
    implementation("org.sol4k:sol4k:0.8.2")
    
    // WEBRTC moderno
    implementation("io.getstream:stream-webrtc-android:1.2.1")

    // Web3j — Atualizado para 4.10.0 (Igual ao Adla)
    implementation("org.web3j:core:4.10.0")

    // Ed25519 puro-Java
    implementation("net.i2p.crypto:eddsa:0.3.0")
}
