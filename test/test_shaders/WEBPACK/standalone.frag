precision lowp float;

float add(float a, float b)
{
  return a + b;
}

void main()
{
  gl_FragColor = vec4(add(0.5, 0.5), 0.0, 0.0, 1.0);
}
