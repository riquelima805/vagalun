plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    // Kotlin package continua com.decentstorage.app.* de propósito (copiado do
    // módulo :app quase sem alteração pra minimizar risco de bug novo) — mas
    // applicationId é outro: é isso que faz o Android tratar como app diferente,
    // instalável junto com o app-node no mesmo aparelho sem conflito.
    namespace = "com.decentstorage.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.decentstorage.browser"
        minSdk = 26
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

    kotlinOptions {
        jvmTarget = "17"
        freeCompilerArgs = freeCompilerArgs + listOf("-Xskip-metadata-version-check")
    }
}

dependencies {
    implementation(platform("org.jetbrains.kotlin:kotlin-bom:1.9.0"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Só o necessário pra ser um peer leve: sem exoplayer, sem sol4k/web3j (não
    // assina transação nenhuma, só verifica assinatura de manifesto), sem work-runtime.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.getstream:stream-webrtc-android:1.2.1")
implementation("org.web3j:core:4.8.8-android")
    implementation("net.i2p.crypto:eddsa:0.3.0")
    // usado só pra decodificar a chave pública do dono do site (Base58 -> bytes)
    implementation("org.sol4k:sol4k:0.8.2")
}

configurations.all {
    resolutionStrategy {
        force("org.jetbrains.kotlin:kotlin-stdlib:1.9.0")
        force("org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.9.0")
        force("org.jetbrains.kotlin:kotlin-stdlib-jdk7:1.9.0")
    }
}
