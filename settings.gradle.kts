pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        jcenter() // Adiciona o JCenter para bibliotecas antigas (como a novacrypto 2019)
        maven { url = uri("https://jitpack.io") }
    }
}

rootProject.name = "DecentStorage"
include(":app")
