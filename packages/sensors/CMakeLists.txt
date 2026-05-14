idf_component_register(
    SRCS "src/imu.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES driver complementary kalman
)
