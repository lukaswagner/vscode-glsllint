precision lowp float;

@import ./dependency;

void main()
{
  gl_FragColor = vec4(add(0.5, 0.5, 0.5), 0.0, 0.0, 1.0);
}
