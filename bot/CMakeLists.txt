cmake_minimum_required(VERSION 3.10)
project(KrakenBot VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -march=native -pthread")

# Dependencies
find_package(CURL REQUIRED)
find_package(nlohmann_json REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(libwebsockets REQUIRED)
find_package(SQLite3 REQUIRED)

# Include directories
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/include)

# Main bot executable
add_executable(kraken_bot
    src/main.cpp
    src/kraken_api.cpp
    src/learning_engine.cpp
)

target_link_libraries(kraken_bot
    PRIVATE
    CURL::libcurl
    nlohmann_json::nlohmann_json
    OpenSSL::SSL OpenSSL::Crypto
    websockets
    SQLite::SQLite3
    pthread
)

# Build tests
# enable_testing()
# add_subdirectory(tests)
